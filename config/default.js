const config = {
    app: "n2",
    cluster: {
	region: 'us-east1',
	zone: 'us-east1-b',
	csr: {
	    "C": "",
	    "L": "",
	    "O": "",
	    "OU": "",
	    "ST": ""
	},
	controllers: {
	    prefix: 'controller',
	    count: 1
	},
	workers: {
	    prefix: 'worker',
	    count: 1
	},
	ports: {
	    api: 6443,
	    health: 80,
	    ssh: 22,
	    etcd: {
		client: 2379,
		peer: 2380
	    }
	},
	image: {
	    project: 'ubuntu-os-cloud',
	    family: 'ubuntu-1810',
	},
	machine: {
	    type: 'g1-small',
//	    type: 'f1-micro',
	},
	options: (_=config,type) => ''
	    + ` --machine-type=${_.cluster.machine.type}`
	    + ` --image-project=${_.cluster.image.project}`
	    + ` --image-family=${_.cluster.image.family}`
	    + ` --subnet=${_.app}`
	    + ` --labels=roles=${type} --tags=${type}`
	    + ` --preemptible --no-restart-on-failure`
    }
}


module.exports = config

