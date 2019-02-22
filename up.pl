#!/usr/bin/perl

use strict;
use warnings;

my $APP="n2";
my $RANGE='10.62.0.0/24';
my $UPSTREAM_IP='10.62.0.100';
my $UPSTREAM1_IP='10.62.0.101';
my $UPSTREAM2_IP='10.62.0.102';
my $DOWNSTREAM1_IP='10.62.0.201';
my $DOWNSTREAM2_IP='10.62.0.202';
my $API_PORT='6443';
my $ETCD_CLIENT_PORT='2379';
my $ETCD_PEER_PORT='2380';
my $IMAGE_PROJECT='ubuntu-os-cloud';
my $IMAGE_FAMILY='ubuntu-minimal-1810';
my $IMAGE_OPTS="--image-project=$IMAGE_PROJECT --image-family=$IMAGE_FAMILY";
#my $MACHINE_TYPE='g1-small'
my $MACHINE_TYPE='f1-micro';

my $OPTS="--machine-type=$MACHINE_TYPE --subnet=$APP $IMAGE_OPTS --preemptible --no-restart-on-failure";
my $UPSTREAM_OPTS="$OPTS --labels=role=upstream --tags=upstream";
my $DOWNSTREAM_OPTS="$OPTS --labels=role=downstream --tags=downstream";

my $UPSTREAM1="$APP-upstream1";;
my $UPSTREAM2="$APP-upstream2";
my $DOWNSTREAM1="$APP-downstream1";
my $DOWNSTREAM2="$APP-downstream2";

my $UPDATE="sudo apt-get update -y";
my $INSTALL="sudo apt-get install -y";
my $COMMON_DEPS="vim";
my $INSTALL_UP="$INSTALL $COMMON_DEPS etcd";
my $INSTALL_DOWN="$INSTALL $COMMON_DEPS containerd";
my $SSH="gcloud compute ssh";
my $SNAP="sudo snap install --classic kubelet";

sub cloud_up() {

    # network setup
    system "gcloud compute networks create $APP --subnet-mode=custom";
    system "gcloud compute networks subnets create $APP --network $APP --range=$RANGE";
    # load balancer
    system "gcloud compute https-health-checks create $APP --port=$API_PORT";
system "gcloud compute target-pools create $APP --http-health-check=$APP";
system "gcloud compute forwarding-rules create $APP --load-balancing-scheme=INTERNAL --target-pool=$APP  --ports=$API_PORT,$ETCD_CLIENT_PORT,$ETCD_PEER_PORT --address=$APP";

system "gcloud compute addresses create $APP        --subnet=$APP        --addresses=$UPSTREAM_IP     --network-tier=STANDARD";

system "gcloud compute addresses create upstream1 --subnet=$APP --addresses=$UPSTREAM1_IP --network-tier=STANDARD";
system "gcloud compute addresses create upstream2 --subnet=$APP --addresses=$UPSTREAM2_IP  --network-tier=STANDARD";
system "gcloud compute addresses create downstream1 --subnet=$APP --addresses=$DOWNSTREAM1_IP  --network-tier=STANDARD";

system "gcloud compute addresses create downstream2  --subnet=$APP        --addresses=$DOWNSTREAM2_IP     --network-tier=STANDARD";

system "gcloud compute instances create $UPSTREAM1 $UPSTREAM_OPTS --address=upstream1";
#system "gcloud compute instances create $UPSTREAM2 $UPSTREAM_OPTS --address=upstream2";
#system "gcloud compute instances create $DOWNSTREAM1 $DOWNSTREAM_OPTS --address=downstream1";
#system "gcloud compute instances create $DOWNSTREAM2 $DOWNSTREAM_OPTS --address=downstream2";


foreach my $instance (qw/upstream1/) {
#foreach my $instance (qw/upstream1 upstream2 downstream1 downstream2/) {
    system "$SSH $instance -- $UPDATE";
}

foreach my $instance (qw/upstream1/) {
#foreach my $instance (qw/upstream1 upstream2/) {
    system "$SSH $instance -- $INSTALL_UP";
}
foreach my $instance (qw/downstream1 downstream2/) {
#    system "$SSH $instance -- $INSTALL_DOWN";
}

foreach my $instance (qw/upstream1/) {
#foreach my $instance (qw/upstream1 upstream2 downstream1 downstream2/) {
    system "$SSH $instance -- $SNAP";
}


#system "gcloud compute target-pools add-instances $APP --instances=$UPSTREAM1,$UPSTREAM2";
system "gcloud compute target-pools add-instances $APP --instances=$UPSTREAM1";
}

sub generate_certs {
    foreach my $cn (qw/ca
	kube-controller-manager kube-proxy kubernetes kube-scheduler service-account
	upstream1 upstream2
	downstream1 downstream2
		     /) {
	my $init = $cn eq 'ca';
	my $hostname = '';
	if ($cn =~ /(up|down)stream(\d)/) {
	    my ($dir, $num) = ($1, $2);
	    my $ip = ip($cn);
	    $hostname = "-hostname=127.0.0.1,$cn,$ip";
	    if ($dir eq 'up') {
		$hostname .= ',' . ip('upstream');
	    }
	} elsif ($cn eq 'kubernetes') {
	    $hostname .= '-hostname=127.0.0.1,kubernetes.default,' . ip('upstream')
		. ',' . ip('upstream1') . ',' . ip('upstream2');
	}
	my $ca = ($init) ? '-initca' : "-ca=certs/ca.pem -ca-key=certs/ca-key.pem";
	my $cmd = "cfssl $ca $hostname certs/${cn}-csr.json | cfssljson -bare certs/$cn";
	print "$cmd\n";
    }
}

sub ip {
    my ($instance) = @_;
    my $ip = '10.62.0.' . (($instance =~ /up/) ? '10' : '20');
    if ($instance =~ /1/) {
	$ip .= '1';
    } elsif ($instance =~ /2/) {
	$ip .= '2';
    } else {
	$ip .= '0';
    }
    return $ip;
}


generate_certs();
